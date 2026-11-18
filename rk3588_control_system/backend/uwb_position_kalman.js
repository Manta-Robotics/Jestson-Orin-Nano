const finite=Number.isFinite;

// Receiver-frame position/velocity CV Kalman. Units are metres and seconds;
// process noise and Joseph covariance correction match the bridge Axis model.
class Axis {
  constructor(position,variance,velocityVariance){
    this.position=position;this.velocity=0;this.p00=variance;this.p01=0;this.p11=velocityVariance;
  }
  predict(dt,q){
    const density=q*.1,p00=this.p00,p01=this.p01,p11=this.p11;
    this.position+=this.velocity*dt;
    this.p00=p00+2*dt*p01+dt*dt*p11+density*dt**3/3;
    this.p01=p01+dt*p11+density*dt*dt/2;this.p11=p11+density*dt;
  }
  correct(z,variance){
    const {p00,p01,p11}=this,s=p00+variance,k0=p00/s,k1=p01/s,residual=z-this.position;
    this.position+=k0*residual;this.velocity+=k1*residual;
    this.p00=Math.max(1e-9,(1-k0)**2*p00+k0*k0*variance);
    this.p01=(1-k0)*(p01-k1*p00)+k0*k1*variance;
    this.p11=Math.max(1e-9,p11-2*k1*p01+k1*k1*(p00+variance));
    const bound=Math.sqrt(this.p00*this.p11);this.p01=Math.max(-bound,Math.min(bound,this.p01));
  }
}

export class UwbPositionKalman {
  constructor(config={}){
    this.config={distance_std_m:.25,angle_std_deg:5,acceleration_std_mps2:2,
      initial_velocity_std_mps:2,max_relative_speed_mps:6,...config};
    for(const key of ['distance_std_m','angle_std_deg','acceleration_std_mps2',
      'initial_velocity_std_mps','max_relative_speed_mps']) {
      if(!finite(this.config[key])||this.config[key]<=0)throw new Error(`Invalid position Kalman parameter: ${key}`);
    }
    this.reset();
  }
  reset(){this.axes=null;this.at=null;this.acceptedCount=0;this.uncertaintyM=null;}
  update(distanceCm,azimuthDeg,at){
    if(![distanceCm,azimuthDeg,at].every(finite)){
      this.reset();return {ready:false,reason:'non_finite_measurement'};
    }
    if(this.at!==null&&at<=this.at)return {ready:false,reason:'non_positive_time_delta'};
    const distance=distanceCm/100,angle=azimuthDeg*Math.PI/180;
    const measurement=[distance*Math.cos(angle),distance*Math.sin(angle)];
    const p=this.config,variance=p.distance_std_m**2+(distance*p.angle_std_deg*Math.PI/180)**2;
    if(!this.axes)this.axes=measurement.map(z=>new Axis(z,variance,p.initial_velocity_std_mps**2));
    else {
      const dt=Math.min(10,(at-this.at)/1000);
      for(let i=0;i<2;i++){
        this.axes[i].predict(dt,p.acceleration_std_mps2**2);
        this.axes[i].correct(measurement[i],variance);
      }
    }
    if(!this.axes.every(a=>[a.position,a.velocity,a.p00,a.p01,a.p11].every(finite))){
      this.reset();return {ready:false,reason:'kalman_numerical_failure'};
    }
    const speed=Math.hypot(...this.axes.map(a=>a.velocity));
    if(speed>p.max_relative_speed_mps)for(const a of this.axes)a.velocity*=p.max_relative_speed_mps/speed;
    this.at=at;this.acceptedCount++;this.uncertaintyM=2*Math.sqrt(this.axes[0].p00+this.axes[1].p00);
    const [x,y]=this.axes.map(a=>a.position);
    return {ready:true,smoothedDistanceCm:Math.hypot(x,y)*100,
      smoothedAzimuthDeg:Math.atan2(y,x)*180/Math.PI,smoothedXcm:x*100,smoothedYcm:y*100};
  }
  diagnostics(){return {enabled:true,model:'cv_2d_position_velocity',frame:'receiver',
    acceptedCount:this.acceptedCount,measurementMonotonicMs:this.at,uncertaintyM:this.uncertaintyM};}
}
